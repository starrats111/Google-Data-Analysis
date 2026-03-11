import uuid
from typing import List, Optional, Dict

from google.ads.googleads.client import GoogleAdsClient
from google.ads.googleads.v22.common.types.ad_asset import AdTextAsset
from google.ads.googleads.v22.enums.types.served_asset_field_type import (
    ServedAssetFieldTypeEnum,
)
from google.ads.googleads.v22.resources.types.ad_group import AdGroup
from google.ads.googleads.v22.resources.types.ad_group_ad import AdGroupAd
from google.ads.googleads.v22.resources.types.ad_group_criterion import (
    AdGroupCriterion,
)
from google.ads.googleads.v22.resources.types.campaign import Campaign
from google.ads.googleads.v22.resources.types.campaign_budget import (
    CampaignBudget,
)
from google.ads.googleads.v22.resources.types.campaign_criterion import (
    CampaignCriterion,
)
from google.ads.googleads.v22.resources.types.customer_customizer import (
    CustomerCustomizer,
)
from google.ads.googleads.v22.resources.types.customizer_attribute import (
    CustomizerAttribute,
)
from google.ads.googleads.v22.services import MutateCampaignAssetsResponse, CampaignAssetOperation, \
    MutateAssetsResponse, AssetOperation
from google.ads.googleads.v22.services.services.ad_group_ad_service import (
    AdGroupAdServiceClient,
)
from google.ads.googleads.v22.services.services.ad_group_criterion_service import (
    AdGroupCriterionServiceClient,
)
from google.ads.googleads.v22.services.services.ad_group_service import (
    AdGroupServiceClient,
)
from google.ads.googleads.v22.services.services.asset_service import AssetServiceClient
from google.ads.googleads.v22.services.services.campaign_asset_service import CampaignAssetServiceClient
from google.ads.googleads.v22.services.services.campaign_budget_service import (
    CampaignBudgetServiceClient,
)
from google.ads.googleads.v22.services.services.campaign_criterion_service import (
    CampaignCriterionServiceClient,
)
from google.ads.googleads.v22.services.services.campaign_service import (
    CampaignServiceClient,
)
from google.ads.googleads.v22.services.services.customer_customizer_service import (
    CustomerCustomizerServiceClient,
)
from google.ads.googleads.v22.services.services.customizer_attribute_service import (
    CustomizerAttributeServiceClient,
)
from google.ads.googleads.v22.services.services.geo_target_constant_service import (
    GeoTargetConstantServiceClient,
)
from google.ads.googleads.v22.services.types.geo_target_constant_service import (
    SuggestGeoTargetConstantsRequest,
    SuggestGeoTargetConstantsResponse,
)
from google.ads.googleads.v22.services.types.ad_group_ad_service import (
    AdGroupAdOperation,
    MutateAdGroupAdsResponse,
)
from google.ads.googleads.v22.services.types.ad_group_criterion_service import (
    AdGroupCriterionOperation,
    MutateAdGroupCriteriaResponse,
)
from google.ads.googleads.v22.services.types.ad_group_service import (
    AdGroupOperation,
    MutateAdGroupsResponse,
)
from google.ads.googleads.v22.services.types.campaign_budget_service import (
    CampaignBudgetOperation,
    MutateCampaignBudgetsResponse,
)
from google.ads.googleads.v22.services.types.campaign_criterion_service import (
    CampaignCriterionOperation,
    MutateCampaignCriteriaResponse,
)
from google.ads.googleads.v22.services.types.campaign_service import (
    CampaignOperation,
    MutateCampaignsResponse,
)
from google.ads.googleads.v22.services.types.customer_customizer_service import (
    CustomerCustomizerOperation,
    MutateCustomerCustomizersResponse,
)
from google.ads.googleads.v22.services.types.customizer_attribute_service import (
    CustomizerAttributeOperation,
    MutateCustomizerAttributesResponse,
)

from load_ad_with_csv import  counrty_dict

# Keywords from user.
# KEYWORD_TEXT_EXACT = ad_dict['Keyword']
# KEYWORD_TEXT_PHRASE = "example of phrase match"
# KEYWORD_TEXT_BROAD = "example of broad match"

# Geo targeting from user.
GEO_LOCATION_1 = "Buenos aires"
GEO_LOCATION_2 = "San Isidro"
GEO_LOCATION_3 = "Mar del Plata"

# LOCALE and COUNTRY_CODE are used for geo targeting.
# LOCALE is using ISO 639-1 format. If an invalid LOCALE is given,
# 'es' is used by default.
LOCALE = "es"


# A list of country codes can be referenced here:
# https://developers.google.com/google-ads/api/reference/data/geotargets

def create(
        ad_dict,
        client: GoogleAdsClient,
        customer_id: str,
        resource_name,
        customizer_attribute_name: Optional[str] = None,

) -> None:
    """
    The main method that creates all necessary entities for the example.

    Args:
        client: an initialized GoogleAdsClient instance.
        customer_id: a client customer ID.
        customizer_attribute_name: The name of the customizer attribute to be
            created
    """
    if customizer_attribute_name:
        customizer_attribute_resource_name: str = create_customizer_attribute(
            client, customer_id, customizer_attribute_name
        )
    else:
        customizer_attribute_resource_name: str = resource_name
    link_customizer_attribute_to_customer(
        client, customer_id, customizer_attribute_resource_name
    )

    # Create a budget, which can be shared by multiple campaigns.
    campaign_budget: str = create_campaign_budget(client, customer_id, ad_dict)

    campaign_resource_name: str = create_campaign(
        client, customer_id, campaign_budget, ad_dict
    )

    ad_group_resource_name: str = create_ad_group(
        client, customer_id, campaign_resource_name, ad_dict
    )

    create_ad_group_ad(
        client, customer_id, ad_group_resource_name, customizer_attribute_name, ad_dict
    )

    add_keywords(client, customer_id, ad_group_resource_name, ad_dict)

    add_geo_targeting(client, customer_id, campaign_resource_name, ad_dict)
    # 添加站内链接
    add_sitelink_extension(
        client,
        customer_id,
        campaign_resource_name,
        link_text=ad_dict['Sitelink Text'],
        final_url=ad_dict['Sitelink URL'],
        description1=ad_dict['Sitelink Desc 1'],
        description2=ad_dict['Sitelink Desc 2']
    )

def add_sitelink_extension(
        client: GoogleAdsClient,
        customer_id: str,
        campaign_resource_name: str,
        link_text: str,
        final_url: str,
        description1: str,
        description2: str,
) -> None:
    """
    Creates a Sitelink Asset and links it to the Campaign.

    Args:
        client: An initialized GoogleAdsClient instance.
        customer_id: A client customer ID.
        campaign_resource_name: The resource name of the campaign to link the sitelink to.
        link_text: The displayed text for the sitelink.
        final_url: The destination URL for the sitelink.
        description1: First description line.
        description2: Second description line.
    """
    asset_service: AssetServiceClient = client.get_service("AssetService")
    campaign_asset_service: CampaignAssetServiceClient = client.get_service("CampaignAssetService")

    # 1. 创建 Sitelink Asset (站内链接素材资源)
    asset_operation: AssetOperation = client.get_type("AssetOperation")
    asset = asset_operation.create

    # 设置最终到达网址 (Final URL)
    asset.final_urls.append(final_url)

    # 设置站内链接的类型为 SITELINK
    asset.type_ = client.enums.AssetTypeEnum.SITELINK


    # 无需单独创建 sitelink_asset 对象
    # sitelink_asset = client.get_type("SitelinkAsset")

    # 直接修改 asset.sitelink_asset 的属性
    asset.sitelink_asset.link_text = link_text  # 站内链接文字
    asset.sitelink_asset.description1 = description1  # 描述行 1
    asset.sitelink_asset.description2 = description2  # 描述行 2

    # 提交 Asset 创建请求
    asset_response: MutateAssetsResponse = asset_service.mutate_assets(
        customer_id=customer_id, operations=[asset_operation]
    )
    sitelink_asset_resource_name = asset_response.results[0].resource_name
    print(f"Created Sitelink Asset with resource name: '{sitelink_asset_resource_name}'")

    # 2. 将 Sitelink Asset 关联到 Campaign (广告系列)
    campaign_asset_operation: CampaignAssetOperation = client.get_type("CampaignAssetOperation")
    campaign_asset = campaign_asset_operation.create

    campaign_asset.campaign = campaign_resource_name
    campaign_asset.asset = sitelink_asset_resource_name

    # 必须将字段类型设置为 SITELINK
    campaign_asset.field_type = client.enums.AssetFieldTypeEnum.SITELINK

    # 提交 CampaignAsset 关联请求
    campaign_asset_response: MutateCampaignAssetsResponse = campaign_asset_service.mutate_campaign_assets(
        customer_id=customer_id, operations=[campaign_asset_operation]
    )
    sitelink_campaign_asset_resource_name = campaign_asset_response.results[0].resource_name
    print(f"Linked Sitelink Asset to Campaign with resource name: '{sitelink_campaign_asset_resource_name}'")


def create_customizer_attribute(
        client: GoogleAdsClient, customer_id: str, customizer_attribute_name: str
) -> str:
    """Creates a customizer attribute with the given customizer attribute name.

    Args:
        client: an initialized GoogleAdsClient instance.
        customer_id: a client customer ID.
        customizer_attribute_name: the name for the customizer attribute.

    Returns:
        A resource name for a customizer attribute.
    """
    # Create a customizer attribute operation for creating a customizer
    # attribute.
    operation: CustomizerAttributeOperation = client.get_type(
        "CustomizerAttributeOperation"
    )
    # Create a customizer attribute with the specified name.
    customizer_attribute: CustomizerAttribute = operation.create
    customizer_attribute.name = customizer_attribute_name
    # Specify the type to be 'PRICE' so that we can dynamically customize the
    # part of the ad's description that is a price of a product/service we
    # advertise.
    customizer_attribute.type_ = client.enums.CustomizerAttributeTypeEnum.PRICE

    # Issue a mutate request to add the customizer attribute and prints its
    # information.
    customizer_attribute_service: CustomizerAttributeServiceClient = (
        client.get_service("CustomizerAttributeService")
    )
    response: MutateCustomizerAttributesResponse = (
        customizer_attribute_service.mutate_customizer_attributes(
            customer_id=customer_id, operations=[operation]
        )
    )
    resource_name: str = response.results[0].resource_name

    print(f"Added a customizer attribute with resource name: '{resource_name}'")

    return resource_name


def link_customizer_attribute_to_customer(
        client: GoogleAdsClient,
        customer_id: str,
        customizer_attribute_resource_name: str,
) -> None:
    """Links the customizer attribute to the customer.

    Args:
        client: an initialized GoogleAdsClient instance.
            customer_id: a client customer ID.
        customizer_attribute_resource_name: a resource name for  customizer
            attribute.
    """
    # Create a customer customizer operation.
    operation: CustomerCustomizerOperation = client.get_type(
        "CustomerCustomizerOperation"
    )
    # Create a customer customizer with the value to be used in the responsive
    # search ad.
    customer_customizer: CustomerCustomizer = operation.create
    customer_customizer.customizer_attribute = (
        customizer_attribute_resource_name
    )
    customer_customizer.value.type_ = (
        client.enums.CustomizerAttributeTypeEnum.PRICE
    )
    # The ad customizer will dynamically replace the placeholder with this value
    # when the ad serves.
    customer_customizer.value.string_value = "100USD"

    customer_customizer_service: CustomerCustomizerServiceClient = (
        client.get_service("CustomerCustomizerService")
    )
    # Issue a mutate request to create the customer customizer and prints its
    # information.
    response: MutateCustomerCustomizersResponse = (
        customer_customizer_service.mutate_customer_customizers(
            customer_id=customer_id, operations=[operation]
        )
    )
    resource_name: str = response.results[0].resource_name

    print(
        f"Added a customer customizer to the customer with resource name: '{resource_name}'"
    )


def create_ad_text_asset(
        client: GoogleAdsClient,
        text: str,
        pinned_field: Optional[
            ServedAssetFieldTypeEnum.ServedAssetFieldType
        ] = None,
) -> AdTextAsset:
    """Create an AdTextAsset.

    Args:
        client: an initialized GoogleAdsClient instance.
        text: text for headlines and descriptions.
        pinned_field: to pin a text asset so it always shows in the ad.

    Returns:
        An AdTextAsset.
    """
    ad_text_asset: AdTextAsset = client.get_type("AdTextAsset")
    ad_text_asset.text = text
    if pinned_field:
        ad_text_asset.pinned_field = pinned_field
    return ad_text_asset


def create_ad_text_asset_with_customizer(
        client: GoogleAdsClient, customizer_attribute_resource_name: str
) -> AdTextAsset:
    """Create an AdTextAsset.
    Args:
        client: an initialized GoogleAdsClient instance.
        customizer_attribute_resource_name: The resource name of the customizer attribute.

    Returns:
        An AdTextAsset.
    """
    ad_text_asset: AdTextAsset = client.get_type("AdTextAsset")

    # Create this particular description using the ad customizer. Visit
    # https://developers.google.com/google-ads/api/docs/ads/customize-responsive-search-ads#ad_customizers_in_responsive_search_ads
    # for details about the placeholder format. The ad customizer replaces the
    # placeholder with the value we previously created and linked to the
    # customer using CustomerCustomizer.
    ad_text_asset.text = (
        f"Just {{CUSTOMIZER.{customizer_attribute_resource_name}:10USD}}"
    )

    return ad_text_asset


def create_campaign_budget(client: GoogleAdsClient, customer_id: str, ad_dict) -> str:
    """Creates campaign budget resource.

    Args:
      client: an initialized GoogleAdsClient instance.
      customer_id: a client customer ID.

    Returns:
      Campaign budget resource name.
    """
    # Create a budget, which can be shared by multiple campaigns.
    campaign_budget_service: CampaignBudgetServiceClient = client.get_service(
        "CampaignBudgetService"
    )
    campaign_budget_operation: CampaignBudgetOperation = client.get_type(
        "CampaignBudgetOperation"
    )
    campaign_budget: CampaignBudget = campaign_budget_operation.create
    campaign_budget.name = f"Campaign budget {uuid.uuid4()}"
    campaign_budget.delivery_method = (
        client.enums.BudgetDeliveryMethodEnum.STANDARD
    )
    campaign_budget.explicitly_shared = False
    # campaign_budget.type_ = client.enums.BudgetPeriodEnum.DAILY #Budget type
    campaign_budget.type_ = getattr(client.enums.BudgetPeriodEnum, ad_dict['Budget type'].upper())
    campaign_budget.amount_micros = int(float(ad_dict['Budget']) * 1000000)

    # Add budget.
    campaign_budget_response: MutateCampaignBudgetsResponse = (
        campaign_budget_service.mutate_campaign_budgets(
            customer_id=customer_id, operations=[campaign_budget_operation]
        )
    )

    return campaign_budget_response.results[0].resource_name


def get_language_resource_names_by_code(
        client: GoogleAdsClient, customer_id: str, language_codes: List[str]
) -> Dict[str, str]:
    """
    Queries LanguageConstant resources based on ISO language codes (e.g., 'en', 'zh').

    Args:
      client: An initialized GoogleAdsClient instance.
      customer_id: A client customer ID.
      language_codes: A list of two-letter language codes (e.g., ['en', 'zh']).

    Returns:
      A dictionary mapping language code to its resource name.
    """
    googleads_service = client.get_service("GoogleAdsService")

    # 构建 WHERE 子句，用于过滤所需的语言代码
    # 例如: "language_constant.code IN ('en', 'zh')"
    codes_str = ", ".join(f"'{code}'" for code in language_codes)

    query = f"""
        SELECT 
            language_constant.resource_name, 
            language_constant.code
        FROM 
            language_constant
        WHERE 
            language_constant.code IN ({codes_str})
            AND language_constant.targetable = TRUE
    """

    language_map = {}

    # 使用 GoogleAdsService 执行查询
    response = googleads_service.search_stream(
        customer_id=customer_id,
        query=query
    )

    for batch in response:
        for row in batch.results:
            lang_code = row.language_constant.code
            resource_name = row.language_constant.resource_name
            language_map[lang_code] = resource_name
            print(f"Found Language: Code={lang_code}, Resource Name={resource_name}")

    return language_map

def create_campaign(
        client: GoogleAdsClient, customer_id: str, campaign_budget: str, ad_dict
) -> str:
    """Creates campaign resource.

    Args:
      client: an initialized GoogleAdsClient instance.
      customer_id: a client customer ID.
      campaign_budget: a budget resource name.

    Returns:
      Campaign resource name.
    """
    campaign_service: CampaignServiceClient = client.get_service(
        "CampaignService"
    )
    campaign_operation: CampaignOperation = client.get_type("CampaignOperation")
    campaign: Campaign = campaign_operation.create
    eu_political_advertising_status_enum = client.get_type(
        "EuPoliticalAdvertisingStatusEnum").EuPoliticalAdvertisingStatus
    # 2. 设置广告系列操作
    # ... 其他必填的广告系列字段 (如 name, bidding_strategy_type 等)
    # *** 修正错误：添加缺失的必填字段 ***
    campaign.contains_eu_political_advertising = eu_political_advertising_status_enum.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING
    import datetime
    now = datetime.datetime.now()
    formatted_time = now.strftime('%Y%m%d%H%M%S')
    campaign.name = f"Testing RSA via API {formatted_time}"
    campaign.advertising_channel_type = (
        # client.enums.AdvertisingChannelTypeEnum.SEARCH
        getattr(client.enums.AdvertisingChannelTypeEnum, ad_dict['Campaign type'].upper())
    )
    campaign.geo_target_type_setting.positive_geo_target_type = (
        client.enums.PositiveGeoTargetTypeEnum.PRESENCE
    )
    campaign.bidding_strategy_type = client.enums.BiddingStrategyTypeEnum.TARGET_SPEND

    # Recommendation: Set the campaign to PAUSED when creating it to prevent
    # the ads from immediately serving. Set to ENABLED once you've added
    # targeting and the ads are ready to serve.
    campaign.status = getattr(client.enums.CampaignStatusEnum, ad_dict['Campaign Status'].upper())
    campaign.final_url_suffix = ad_dict['Final URL suffix']

    # Set the bidding strategy and budget.
    # The bidding strategy for Maximize Clicks is TargetSpend.
    # The target_spend_micros is deprecated so don't put any value.
    # See other bidding strategies you can select in the link below.
    # https://developers.google.com/google-ads/api/reference/rpc/latest/Campaign#campaign_bidding_strategy
    campaign.target_spend.cpc_bid_ceiling_micros = int(float(ad_dict['Max CPC']) * 1000000) #点击出价策略
    campaign.campaign_budget = campaign_budget
    # Set the campaign network options.
    campaign.network_settings.target_google_search = True
    campaign.network_settings.target_search_network = True
    campaign.network_settings.target_partner_search_network = False
    # Enable Display Expansion on Search campaigns. For more details see:
    # https://support.google.com/google-ads/answer/7193800
    campaign.network_settings.target_content_network = False #展示网路

    # # Optional: Set the start date.
    # start_time = datetime.date.today() + datetime.timedelta(days=1)
    # campaign.start_date = datetime.date.strftime(start_time, _DATE_FORMAT)

    # # Optional: Set the end date.
    # end_time = start_time + datetime.timedelta(weeks=4)
    # campaign.end_date = datetime.date.strftime(end_time, _DATE_FORMAT)

    # Add the campaign.
    campaign_response: MutateCampaignsResponse = (
        campaign_service.mutate_campaigns(
            customer_id=customer_id, operations=[campaign_operation]
        )
    )
    resource_name: str = campaign_response.results[0].resource_name
    print(f"Created campaign {resource_name}.")
    return resource_name


def create_ad_group(
        client: GoogleAdsClient,
        customer_id: str,
        campaign_resource_name: str,
        ad_dict
) -> str:
    """Creates ad group.

    Args:
      client: an initialized GoogleAdsClient instance.
      customer_id: a client customer ID.
      campaign_resource_name: a campaign resource name.

    Returns:
      Ad group ID.
    """
    ad_group_service: AdGroupServiceClient = client.get_service(
        "AdGroupService"
    )

    ad_group_operation: AdGroupOperation = client.get_type("AdGroupOperation")
    ad_group: AdGroup = ad_group_operation.create
    ad_group.name = ad_dict['Ad Group']
    ad_group.status = client.enums.AdGroupStatusEnum.ENABLED
    ad_group.campaign = campaign_resource_name
    ad_group.type_ = client.enums.AdGroupTypeEnum.SEARCH_STANDARD
    # If you want to set up a max CPC bid uncomment line below.
    # ad_group.cpc_bid_micros = int(0.25 * 1000000) #点击出价策略

    # Add the ad group.
    ad_group_response: MutateAdGroupsResponse = (
        ad_group_service.mutate_ad_groups(
            customer_id=customer_id, operations=[ad_group_operation]
        )
    )
    ad_group_resource_name: str = ad_group_response.results[0].resource_name
    print(f"Created ad group {ad_group_resource_name}.")
    return ad_group_resource_name


def create_ad_group_ad(
        client: GoogleAdsClient,
        customer_id: str,
        ad_group_resource_name: str,
        customizer_attribute_name: Optional[str],
        ad_dict
) -> None:
    """Creates ad group ad.

    Args:
      client: an initialized GoogleAdsClient instance.
      customer_id: a client customer ID.
      ad_group_resource_name: an ad group resource name.
      customizer_attribute_name: (optional) If present, indicates the resource
        name of the customizer attribute to use in one of the descriptions

    Returns:
      None.
    """
    ad_group_ad_service: AdGroupAdServiceClient = client.get_service(
        "AdGroupAdService"
    )

    ad_group_ad_operation: AdGroupAdOperation = client.get_type(
        "AdGroupAdOperation"
    )
    ad_group_ad: AdGroupAd = ad_group_ad_operation.create
    ad_group_ad.status = client.enums.AdGroupAdStatusEnum.ENABLED
    ad_group_ad.ad_group = ad_group_resource_name

    # Set responsive search ad info.
    # https://developers.google.com/google-ads/api/reference/rpc/latest/ResponsiveSearchAdInfo

    # The list of possible final URLs after all cross-domain redirects for the ad.
    ad_group_ad.ad.final_urls.append(ad_dict['Final URL'])

    # Set a pinning to always choose this asset for HEADLINE_1. Pinning is
    # optional; if no pinning is set, then headlines and descriptions will be
    # rotated and the ones that perform best will be used more often.
    headline_list: List[AdTextAsset] = []
    for i in range(15):
        headline_list.append(create_ad_text_asset(client, ad_dict[f'Headline{i+1}']))
    # Headline 1
    # served_asset_enum: ServedAssetFieldTypeEnum = (
    #     client.enums.ServedAssetFieldTypeEnum
    # )
    # pinned_headline: AdTextAsset = create_ad_text_asset(
    #     client, ad_dict['Headline 1'], served_asset_enum.HEADLINE_1
    # )

    # Headline 2 and 3
    ad_group_ad.ad.responsive_search_ad.headlines.extend(headline_list)
    description_list: List[AdTextAsset] = []

    for i in range(4):
        description_list.append(create_ad_text_asset(client, ad_dict[f'Description{i+1}']))
    # Description 1 and 2
    # description_1: AdTextAsset = create_ad_text_asset(client, ad_dict['Description 1'])
    # description_2: Optional[AdTextAsset] = None
    #
    # if customizer_attribute_name:
    #     description_2 = create_ad_text_asset_with_customizer(
    #         client, customizer_attribute_name
    #     )
    # else:
    #     description_2 = create_ad_text_asset(client, ad_dict['Description 2']) #待确认

    ad_group_ad.ad.responsive_search_ad.descriptions.extend(
        description_list
    )

    # Paths
    # First and second part of text that can be appended to the URL in the ad.
    # If you use the examples below, the ad will show
    # https://www.example.com/all-inclusive/deals
    ad_group_ad.ad.responsive_search_ad.path1 = "all-inclusive"
    ad_group_ad.ad.responsive_search_ad.path2 = "deals"

    # Send a request to the server to add a responsive search ad.
    ad_group_ad_response: MutateAdGroupAdsResponse = (
        ad_group_ad_service.mutate_ad_group_ads(
            customer_id=customer_id, operations=[ad_group_ad_operation]
        )
    )

    for result in ad_group_ad_response.results:
        print(
            f"Created responsive search ad with resource name "
            f'"{result.resource_name}".'
        )


def add_keywords(
        client: GoogleAdsClient, customer_id: str, ad_group_resource_name: str, ad_dict
) -> None:
    """Creates keywords.

    Creates 3 keyword match types: EXACT, PHRASE, and BROAD.

    EXACT: ads may show on searches that ARE the same meaning as your keyword.
    PHRASE: ads may show on searches that INCLUDE the meaning of your keyword.
    BROAD: ads may show on searches that RELATE to your keyword.
    For smart bidding, BROAD is the recommended one.

    Args:
      client: an initialized GoogleAdsClient instance.
      customer_id: a client customer ID.
      ad_group_resource_name: an ad group resource name.
    """
    ad_group_criterion_service: AdGroupCriterionServiceClient = (
        client.get_service("AdGroupCriterionService")
    )

    operations: List[AdGroupCriterionOperation] = []

    for i in range(5):
        # Create keyword 1.
        ad_group_criterion_operation: AdGroupCriterionOperation = client.get_type(
            "AdGroupCriterionOperation"
        )
        ad_group_criterion: AdGroupCriterion = ad_group_criterion_operation.create
        ad_group_criterion.ad_group = ad_group_resource_name
        ad_group_criterion.status = client.enums.AdGroupCriterionStatusEnum.ENABLED
        ad_group_criterion.keyword.text = ad_dict[f'Keyword{i+1}']
        ad_group_criterion.keyword.match_type = (
            client.enums.KeywordMatchTypeEnum.PHRASE  # 'Type': 'Phrase match',
        )

        # Uncomment the below line if you want to change this keyword to a negative target.
        # ad_group_criterion.negative = True

        # Optional repeated field
        # ad_group_criterion.final_urls.append(ad_dict['Final URL'])

        # Add operation
        operations.append(ad_group_criterion_operation)

    # # Create keyword 1.
    # ad_group_criterion_operation: AdGroupCriterionOperation = client.get_type(
    #     "AdGroupCriterionOperation"
    # )
    # ad_group_criterion: AdGroupCriterion = ad_group_criterion_operation.create
    # ad_group_criterion.ad_group = ad_group_resource_name
    # ad_group_criterion.status = client.enums.AdGroupCriterionStatusEnum.ENABLED
    # ad_group_criterion.keyword.text = ad_dict['Keyword1']
    # ad_group_criterion.keyword.match_type = (
    #     client.enums.KeywordMatchTypeEnum.PHRASE #'Type': 'Phrase match',
    # )
    #
    # # Uncomment the below line if you want to change this keyword to a negative target.
    # # ad_group_criterion.negative = True
    #
    # # Optional repeated field
    # ad_group_criterion.final_urls.append(ad_dict['Final URL'])
    #
    # # Add operation
    # operations.append(ad_group_criterion_operation)
    #
    # # Create keyword 2.
    # ad_group_criterion_operation: AdGroupCriterionOperation = client.get_type(
    #     "AdGroupCriterionOperation"
    # )
    # ad_group_criterion: AdGroupCriterion = ad_group_criterion_operation.create
    # ad_group_criterion.ad_group = ad_group_resource_name
    # ad_group_criterion.status = client.enums.AdGroupCriterionStatusEnum.ENABLED
    # ad_group_criterion.keyword.text = ad_dict['Keyword2']
    # ad_group_criterion.keyword.match_type = (
    #     client.enums.KeywordMatchTypeEnum.PHRASE
    # )
    #
    # # Uncomment the below line if you want to change this keyword to a negative target.
    # # ad_group_criterion.negative = True
    #
    # # Optional repeated field
    # # ad_group_criterion.final_urls.append('https://www.example.com')
    #
    # # Add operation
    # operations.append(ad_group_criterion_operation)
    #
    # # Create keyword 3.
    # ad_group_criterion_operation: AdGroupCriterionOperation = client.get_type(
    #     "AdGroupCriterionOperation"
    # )
    # ad_group_criterion: AdGroupCriterion = ad_group_criterion_operation.create
    # ad_group_criterion.ad_group = ad_group_resource_name
    # ad_group_criterion.status = client.enums.AdGroupCriterionStatusEnum.ENABLED
    # ad_group_criterion.keyword.text = ad_dict['Keyword3']
    # ad_group_criterion.keyword.match_type = (
    #     client.enums.KeywordMatchTypeEnum.BROAD
    # )
    #
    # # Uncomment the below line if you want to change this keyword to a negative target.
    # # ad_group_criterion.negative = True
    #
    # # Optional repeated field
    # # ad_group_criterion.final_urls.append('https://www.example.com')
    #
    # # Add operation
    # operations.append(ad_group_criterion_operation)

    # Add keywords
    ad_group_criterion_response: MutateAdGroupCriteriaResponse = (
        ad_group_criterion_service.mutate_ad_group_criteria(
            customer_id=customer_id,
            operations=operations,
        )
    )
    for result in ad_group_criterion_response.results:
        print("Created keyword " f"{result.resource_name}.")


def add_geo_targeting(
        client: GoogleAdsClient, customer_id: str, campaign_resource_name: str, ad_dict
) -> None:
    """Creates geo targets.

    Args:
      client: an initialized GoogleAdsClient instance.
      customer_id: a client customer ID.
      campaign_resource_name: an campaign resource name.

    Returns:
      None.
    """
    geo_target_constant_service: GeoTargetConstantServiceClient = (
        client.get_service("GeoTargetConstantService")
    )

    # Search by location names from
    # GeoTargetConstantService.suggest_geo_target_constants() and directly
    # apply GeoTargetConstant.resource_name.
    gtc_request: SuggestGeoTargetConstantsRequest = client.get_type(
        "SuggestGeoTargetConstantsRequest"
    )
    gtc_request.locale = LOCALE
    gtc_request.country_code = counrty_dict[ad_dict['Location']]

    # The location names to get suggested geo target constants.
    gtc_request.location_names.names.extend(
        [GEO_LOCATION_1, GEO_LOCATION_2, GEO_LOCATION_3]
    )

    results: SuggestGeoTargetConstantsResponse = (
        geo_target_constant_service.suggest_geo_target_constants(gtc_request)
    )
    language_code = ad_dict['Languages']
    language_map = get_language_resource_names_by_code(client, customer_id, [language_code])
    language_resource_name = language_map[language_code]

    # 为语言定位创建一个独立的 CampaignCriterion
    language_criterion_operation: CampaignCriterionOperation = (
        client.get_type("CampaignCriterionOperation")
    )
    language_criterion: CampaignCriterion = language_criterion_operation.create

    language_criterion.campaign = campaign_resource_name

    # ⚠️ 修正：直接使用查询到的完整资源名称
    language_criterion.language.language_constant = language_resource_name

    operations: List[CampaignCriterionOperation] = [language_criterion_operation]
    # operations: List[CampaignCriterionOperation] = []
    for suggestion in results.geo_target_constant_suggestions:
        print(
            "geo_target_constant: "
            f"{suggestion.geo_target_constant.resource_name} "
            f"is found in LOCALE ({suggestion.locale}) "
            f"with reach ({suggestion.reach}) "
            f"from search term ({suggestion.search_term})."
        )
        # Create the campaign criterion for location targeting.
        campaign_criterion_operation: CampaignCriterionOperation = (
            client.get_type("CampaignCriterionOperation")
        )
        campaign_criterion: CampaignCriterion = (
            campaign_criterion_operation.create
        )

        campaign_criterion.campaign = campaign_resource_name
        campaign_criterion.location.geo_target_constant = (
            suggestion.geo_target_constant.resource_name
        )
        operations.append(campaign_criterion_operation)

    campaign_criterion_service: CampaignCriterionServiceClient = (
        client.get_service("CampaignCriterionService")
    )
    campaign_criterion_response: MutateCampaignCriteriaResponse = (
        campaign_criterion_service.mutate_campaign_criteria(
            customer_id=customer_id, operations=[*operations]
        )
    )

    for result in campaign_criterion_response.results:
        print(f'Added campaign criterion "{result.resource_name}".')




